import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  stripAnsi,
  stripShellStartup,
  describeLimit,
  detectPhase,
  signature,
  CompletionTracker,
  LIMIT_PATTERNS,
  ERROR_PATTERNS,
  WORKING_PATTERNS,
  IDLE_PATTERNS,
  SIGNATURE_TAIL_LINES,
  DONE_SPINNER,
  isTrustDialog,
  BOOT_BANNER,
  TRUST_CONFIRM_HINT,
  type Phase,
  type PollObservation,
} from "../idle.js";

const ESC = "";

/**
 * Representative pane snippets captured from a live `claude 2.1.177` REPL in
 * tmux 3.5a (the §10 fan-out ground-truth pass). These use the ACTUAL 2.1.177
 * strings: the `❯` prompt char, the `─` box rule, the `* · ✢ ✶ ✻ ✽` star
 * spinner, the live `…(Ns)` working counter, the persisted `for Ns` done line,
 * and the `│ … N tokens` status footer + `⏵⏵ bypass permissions` mode line.
 */
const IDLE_FOOTER =
  "   /tmp │ 󰊠 Haiku 4.5 │ $0.0000                       0 tokens";
const MODE_LINE = "  ⏵⏵ bypass permissions on (shift+tab to cycle)";
const RULE = "─".repeat(60);

const PANES = {
  booting: ["╭─── Claude Code v2.1.177 ───", "Loading…"].join(
    "\n",
  ),
  trust: [
    "Accessing workspace:",
    "/tmp",
    "Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open",
    "source project, or work from your team).",
    "❯ 1. Yes, I trust this folder",
    "  2. No, exit",
    "Enter to confirm · Esc to cancel",
  ].join("\n"),
  idle: [RULE, '❯ Try "refactor <filepath>"', RULE, IDLE_FOOTER, MODE_LINE].join(
    "\n",
  ),
  // Idle AFTER a completed turn: the done spinner line persists above the box.
  idleAfterTurn: [
    "● DONE",
    "✻ Cooked for 3s",
    RULE,
    "❯ ",
    RULE,
    '   /tmp │ 󰊠 Haiku 4.5 │ "Reply with word DONE" │ $0.028 │ █░░ 15%   30830 tokens',
    MODE_LINE,
  ].join("\n"),
  working: ["✻ Percolating… (2s)", RULE, "❯ ", RULE, IDLE_FOOTER].join(
    "\n",
  ),
  spinnerOnly: "* Scampering… (0s)",
  // The done line alone (no live counter) must NOT read as working.
  doneOnly: "✻ Crunched for 1s",
  escOnly: "Running tool (esc to interrupt)",
  limit: ["You've reached your usage limit for this 5-hour block.", MODE_LINE].join(
    "\n",
  ),
  rateLimit: "rate limit exceeded; retry after 60s",
  error: ["API Error: 500 overloaded_error", MODE_LINE].join("\n"),
  connErr: ["Connection error: stream interrupted", MODE_LINE].join("\n"),
  // Benign tool output that USED to false-positive as a terminal failure while
  // the model is still working. Must NOT classify as error/limit.
  toolFatalWhileWorking: [
    "● Bash(git log --oneline)",
    "  ⎿  Error: Exit code 128",
    "     fatal: your current branch 'main' does not have any commits yet",
    "* Hashing… (19s · thinking with high effort)",
  ].join("\n"),
  toolLimitWhileWorking: [
    "● Bash(curl https://docs.example.invalid)",
    "  ⎿  This page mentions a rate limit of 10 requests per minute.",
    "* Hashing… (19s · thinking with high effort)",
  ].join("\n"),
} as const;

describe("stripAnsi", () => {
  it("removes CSI color sequences", () => {
    const colored = `${ESC}[31mred${ESC}[0m text`;
    assert.equal(stripAnsi(colored), "red text");
  });

  it("removes cursor-move CSI sequences", () => {
    const moved = `line1${ESC}[2J${ESC}[Hline2`;
    assert.equal(stripAnsi(moved), "line1line2");
  });

  it("removes OSC hyperlink/title sequences terminated by BEL", () => {
    const osc = `${ESC}]0;window titlebody`;
    assert.equal(stripAnsi(osc), "body");
  });

  it("removes OSC sequences terminated by ST (ESC backslash)", () => {
    const osc = `${ESC}]8;;https://x${ESC}\\link`;
    assert.equal(stripAnsi(osc), "link");
  });

  it("leaves plain text — including uppercase and brackets — untouched", () => {
    const plain = "API Error [boot] Z @ home_dir";
    assert.equal(stripAnsi(plain), plain);
  });

  it("preserves the star spinner glyph", () => {
    assert.equal(stripAnsi("✻ working"), "✻ working");
  });

  it("is idempotent on already-clean text", () => {
    const clean = stripAnsi(PANES.idle);
    assert.equal(stripAnsi(clean), clean);
  });
});

describe("pattern arrays are exported and non-empty", () => {
  it("every pattern group has at least one matcher", () => {
    for (const group of [
      LIMIT_PATTERNS,
      ERROR_PATTERNS,
      WORKING_PATTERNS,
      IDLE_PATTERNS,
    ]) {
      assert.ok(group.length > 0);
    }
  });
});

describe("detectPhase — each phase from 2.1.177 ground-truth snippets", () => {
  it("detects booting from the welcome banner (no idle box yet)", () => {
    assert.equal(detectPhase(PANES.booting), "booting");
  });

  it("treats the trust dialog as booting (waitForBoot auto-confirms it)", () => {
    assert.equal(detectPhase(PANES.trust), "booting");
  });

  it("detects idle from the prompt char + footer + mode line", () => {
    assert.equal(detectPhase(PANES.idle), "idle");
  });

  it("detects idle after a turn (persisted done line does not block idle)", () => {
    assert.equal(detectPhase(PANES.idleAfterTurn), "idle");
  });

  it("detects working from the live …(Ns) counter", () => {
    assert.equal(detectPhase(PANES.working), "working");
  });

  it("detects working from a lone spinner+counter line", () => {
    assert.equal(detectPhase(PANES.spinnerOnly), "working");
  });

  it("does NOT treat the persisted done line as working", () => {
    // No prompt char/footer here so it falls through to booting, but crucially
    // it must NOT be classified as working.
    assert.notEqual(detectPhase(PANES.doneOnly), "working");
  });

  it("still matches the legacy 'esc to interrupt' fallback", () => {
    assert.equal(detectPhase(PANES.escOnly), "working");
  });

  it("detects limit from 'usage limit'", () => {
    assert.equal(detectPhase(PANES.limit), "limit");
  });

  it("detects limit from 'rate limit'", () => {
    assert.equal(detectPhase(PANES.rateLimit), "limit");
  });

  it("detects context/session-size limit text separately from usage quota", () => {
    assert.equal(detectPhase("context window limit reached"), "limit");
  });

  it("detects error from 'API Error:'", () => {
    assert.equal(detectPhase(PANES.error), "error");
  });

  it("detects error from a 'Connection error' (no live spinner)", () => {
    assert.equal(detectPhase(PANES.connErr), "error");
  });

  it("does NOT false-positive on failure-looking tool output while working", () => {
    // REGRESSION: tool-result text printed while the model is still working
    // (`…(19s)` spinner live) must classify as working, not as a terminal REPL
    // failure. This previously killed live ralph iterations mid-think.
    assert.equal(detectPhase(PANES.toolFatalWhileWorking), "working");
    assert.equal(detectPhase(PANES.toolLimitWhileWorking), "working");
  });

  it("detects phase through ANSI noise", () => {
    const noisy = `${ESC}[33m✼ Working…${ESC}[0m (2s)`;
    assert.equal(detectPhase(noisy), "working");
  });
});

describe("detectPhase — priority order working > limit > error > idle > booting", () => {
  it("a live working counter co-present with the idle box resolves to working", () => {
    const both = [
      "✻ generating… (3s)",
      RULE,
      "❯ ",
      RULE,
      IDLE_FOOTER,
      MODE_LINE,
    ].join("\n");
    assert.equal(detectPhase(both), "working");
  });

  it("working beats a co-present limit-looking line", () => {
    const both = "✻ working… (1s) — usage limit reached";
    assert.equal(detectPhase(both), "working");
  });

  it("a LIVE working spinner beats a co-present error line (error is tool output)", () => {
    // While the model is mid-turn (live `…(Ns)` spinner), an error-looking line
    // is tool output, not a terminal REPL failure — working wins. A real API
    // error halts the spinner, at which point error detection takes over.
    const both = "✻ working… (1s)\nAPI Error: overloaded_error";
    assert.equal(detectPhase(both), "working");
  });

  it("error wins when the spinner is NOT live (turn finished on an API error)", () => {
    const both = ["API Error: overloaded_error", MODE_LINE].join("\n");
    assert.equal(detectPhase(both), "error");
  });

  it("limit beats error when both present", () => {
    const both = "API Error: x\nyou've reached your usage limit";
    assert.equal(detectPhase(both), "limit");
  });

  it("idle beats booting when the box is present", () => {
    assert.equal(detectPhase(PANES.idle), "idle");
  });
});

describe("describeLimit", () => {
  it("returns kind, pattern, line, and a bounded excerpt", () => {
    const pane = [
      "line 1",
      "line 2",
      "You've reached your usage limit for this 5-hour block.",
      "line 4",
      "line 5",
    ].join("\n");
    const match = describeLimit(pane, 1);
    assert.deepEqual(match?.kind, "usage");
    assert.equal(match?.line, 3);
    assert.match(match?.pattern ?? "", /usage limit/);
    assert.equal(
      match?.excerpt,
      ["line 2", "You've reached your usage limit for this 5-hour block.", "line 4"].join("\n"),
    );
  });

  it("classifies context/session-size limit text as context", () => {
    assert.equal(describeLimit("Claude Code context window limit reached")?.kind, "context");
  });

  it("returns null when there is no limit text", () => {
    assert.equal(describeLimit("all good"), null);
  });
});

describe("trust / boot helpers", () => {
  it("isTrustDialog matches the safety-check prompt", () => {
    assert.equal(isTrustDialog(PANES.trust), true);
    assert.equal(isTrustDialog(PANES.idle), false);
  });

  it("TRUST_CONFIRM_HINT matches the confirm/cancel footer", () => {
    assert.match(PANES.trust, TRUST_CONFIRM_HINT);
  });

  it("BOOT_BANNER matches the versioned welcome box", () => {
    assert.match(PANES.booting, BOOT_BANNER);
  });

  it("DONE_SPINNER matches the persisted past-tense done line", () => {
    assert.match("✻ Cooked for 3s", DONE_SPINNER);
    assert.doesNotMatch("✻ Percolating… (2s)", DONE_SPINNER);
  });
});

describe("signature — stability + sensitivity", () => {
  it("is deterministic for identical input", () => {
    assert.equal(signature(PANES.idle), signature(PANES.idle));
  });

  it("ignores trailing whitespace and blank trailing lines", () => {
    const a = "hello world\nsecond line";
    const b = "hello world   \nsecond line\n\n  \n";
    assert.equal(signature(a), signature(b));
  });

  it("ignores ANSI coloring (same cleaned text → same hash)", () => {
    const plain = "done: 3 files changed";
    const colored = `${ESC}[32mdone: 3 files changed${ESC}[0m`;
    assert.equal(signature(plain), signature(colored));
  });

  it("changes when visible content changes", () => {
    assert.notEqual(signature("output v1"), signature("output v2"));
  });

  it("ignores the volatile footer/spinner chrome (the §6 fix)", () => {
    // Same conversation region; only the cost/tokens/elapsed/spinner mutate.
    const before = [
      "● the answer is 42",
      "✻ Percolating… (2s)",
      RULE,
      "❯ ",
      RULE,
      '   /tmp │ Haiku 4.5 │ $0.010 │ █░ 5%   100 tokens',
    ].join("\n");
    const after = [
      "● the answer is 42",
      "✻ Cooked for 4s",
      RULE,
      "❯ ",
      RULE,
      '   /tmp │ Haiku 4.5 │ $0.028 │ █░ 15%   30830 tokens',
    ].join("\n");
    assert.equal(
      signature(before),
      signature(after),
      "footer/spinner churn must not change the signature",
    );
  });

  it("still changes when the conversation region changes", () => {
    const a = [
      "● first answer",
      RULE,
      "❯ ",
      RULE,
      IDLE_FOOTER,
    ].join("\n");
    const b = [
      "● second answer",
      RULE,
      "❯ ",
      RULE,
      IDLE_FOOTER,
    ].join("\n");
    assert.notEqual(signature(a), signature(b));
  });

  it("hashes only the last SIGNATURE_TAIL_LINES lines", () => {
    const tail = Array.from(
      { length: SIGNATURE_TAIL_LINES },
      (_, i) => `line ${i}`,
    );
    const withHead = ["DIFFERENT HEADER", ...tail].join("\n");
    const headChanged = ["another header entirely", ...tail].join("\n");
    assert.equal(signature(withHead), signature(headChanged));
  });

  it("returns a 40-char sha1 hex string", () => {
    assert.match(signature(PANES.idle), /^[0-9a-f]{40}$/);
  });
});

/** Helper to build a poll observation tersely. */
function obs(phase: Phase, sig: string, nowMs: number): PollObservation {
  return { phase, signature: sig, nowMs };
}

describe("CompletionTracker — fires only when all conditions met", () => {
  const baseline = "BASELINE_SIG";
  const done = "DONE_SIG";

  it("completes after K stable idle polls with a new signature and sawWorking", () => {
    const t = new CompletionTracker(baseline, 0); // K=2 default
    assert.equal(t.observe(obs("working", "mid", 1000)).complete, false);
    assert.equal(t.observe(obs("idle", done, 5000)).complete, false); // stable=1
    const r = t.observe(obs("idle", done, 9000)); // stable=2
    assert.equal(r.complete, true);
    assert.equal(r.stableCount, 2);
  });

  it("does NOT complete on a single stable idle poll (K not reached)", () => {
    const t = new CompletionTracker(baseline, 0);
    t.observe(obs("working", "mid", 1000));
    const r = t.observe(obs("idle", done, 5000));
    assert.equal(r.complete, false);
    assert.equal(r.stableCount, 1);
  });

  it("resets stable count when signature changes between polls", () => {
    const t = new CompletionTracker(baseline, 0);
    t.observe(obs("working", "mid", 1000));
    t.observe(obs("idle", done, 5000)); // stable=1
    const churn = t.observe(obs("idle", "STILL_PRODUCING", 6000)); // resets
    assert.equal(churn.stableCount, 1);
    assert.equal(churn.complete, false);
    const r = t.observe(obs("idle", "STILL_PRODUCING", 7000)); // stable=2
    assert.equal(r.complete, true);
  });

  it("does NOT complete while phase is still working even if signature stable", () => {
    const t = new CompletionTracker(baseline, 0);
    t.observe(obs("working", done, 1000));
    const r = t.observe(obs("working", done, 2000));
    assert.equal(r.complete, false);
  });

  it("tracks hasSeenWorking", () => {
    const t = new CompletionTracker(baseline, 0);
    assert.equal(t.hasSeenWorking, false);
    t.observe(obs("idle", done, 100));
    assert.equal(t.hasSeenWorking, false);
    t.observe(obs("working", "mid", 200));
    assert.equal(t.hasSeenWorking, true);
  });
});

describe("CompletionTracker — pre-prompt-idle false positive guard", () => {
  it("does NOT complete when signature equals baseline (never moved off idle box)", () => {
    const baseline = "IDLE_BOX_SIG";
    const t = new CompletionTracker(baseline, 0);
    t.observe(obs("idle", baseline, 5000));
    t.observe(obs("idle", baseline, 9000));
    const r = t.observe(obs("idle", baseline, 13000));
    assert.equal(r.complete, false, "baseline==current must never complete");
  });

  it("completes once the pane moves off baseline (after grace, no working seen)", () => {
    const baseline = "IDLE_BOX_SIG";
    const t = new CompletionTracker(baseline, 0);
    t.observe(obs("idle", "answer", 7000)); // stable=1
    const r = t.observe(obs("idle", "answer", 8000)); // stable=2, elapsed>6s
    assert.equal(r.complete, true);
  });

  it("does NOT complete before grace window when working was never seen", () => {
    const baseline = "IDLE_BOX_SIG";
    const t = new CompletionTracker(baseline, 0);
    t.observe(obs("idle", "answer", 2000)); // stable=1
    const r = t.observe(obs("idle", "answer", 3000)); // stable=2 but grace fails
    assert.equal(r.complete, false);
  });
});

describe("CompletionTracker — terminal failures", () => {
  it("reports limit failure without completing", () => {
    const t = new CompletionTracker("base", 0);
    const r = t.observe(obs("limit", "anything", 1000));
    assert.equal(r.complete, false);
    assert.equal(r.failure, "limit");
  });

  it("reports error failure without completing", () => {
    const t = new CompletionTracker("base", 0);
    const r = t.observe(obs("error", "anything", 1000));
    assert.equal(r.complete, false);
    assert.equal(r.failure, "error");
  });
});

describe("CompletionTracker — config overrides", () => {
  it("honors a custom stablePolls (K=3)", () => {
    const t = new CompletionTracker("base", 0, { stablePolls: 3 });
    t.observe(obs("working", "mid", 100));
    assert.equal(t.observe(obs("idle", "done", 1000)).complete, false); // 1
    assert.equal(t.observe(obs("idle", "done", 2000)).complete, false); // 2
    assert.equal(t.observe(obs("idle", "done", 3000)).complete, true); // 3
  });

  it("honors a custom minWorkMs grace window", () => {
    const t = new CompletionTracker("base", 0, { minWorkMs: 1000 });
    t.observe(obs("idle", "done", 1200)); // stable=1
    const r = t.observe(obs("idle", "done", 1500)); // stable=2
    assert.equal(r.complete, true);
  });
});

describe("stripShellStartup (TASK 1.1 — harvest hygiene)", () => {
  // A realistic NixOS login-shell banner (fastfetch art + sysinfo + calendar)
  // followed by the echoed launch command and the model's real output.
  const banner = [
    "    ▟███████████████████▙ ▜███▙    ▟██▙        Packages: 1685 (nix-system)",
    "          ▟███▛             ▜██▛ ▟███▛         Shell: zsh 5.9",
    "OS: NixOS 25.05",
    "Host: nixos-server",
    "Kernel: 6.12.63",
    "Memory: 6.69 GiB / 19.53 GiB",
    "      June 2026             July 2026",
    "Mo Tu We Th Fr Sa Su  Mo Tu We Th Fr Sa Su",
    " 1  2  3  4  5  6  7         1  2  3  4  5",
    "➜  /work/app",
  ].join("\n");

  it("drops everything up to and including the echoed claude launch line", () => {
    const pane = [
      banner,
      "➜ claude --dangerously-skip-permissions --plugin-dir /opt/plugins --model haiku",
      "● Done. Created ok.txt with OK.",
      "❯ ? for shortcuts",
    ].join("\n");
    const out = stripShellStartup(pane);
    assert.ok(!out.includes("fastfetch") && !out.includes("OS: NixOS"));
    assert.ok(!out.includes("Mo Tu We"));
    assert.ok(!out.includes("--dangerously-skip-permissions"));
    assert.ok(out.includes("● Done. Created ok.txt with OK."));
  });

  it("strips a leading shell-startup block when no launch line is captured (fallback)", () => {
    // The conservative fallback strips a CONTIGUOUS leading run of recognised
    // noise (sysinfo rows + calendar header/body) and stops at the first
    // non-noise line. (fastfetch art lines that carry appended sysinfo text on
    // the right are intentionally NOT stripped here — the primary launch-line
    // path handles the real capture; this fallback is a best-effort backstop.)
    const noiseOnly = [
      "OS: NixOS 25.05",
      "Host: nixos-server",
      "Kernel: 6.12.63",
      "Memory: 6.69 GiB / 19.53 GiB",
      "Mo Tu We Th Fr Sa Su  Mo Tu We Th Fr Sa Su",
      " 1  2  3  4  5  6  7         1  2  3  4  5",
    ].join("\n");
    const pane = [noiseOnly, "● The actual model answer is here.", "❯"].join("\n");
    const out = stripShellStartup(pane);
    assert.ok(!out.includes("OS: NixOS"));
    assert.ok(!out.includes("Mo Tu We"));
    assert.ok(out.startsWith("● The actual model answer is here."));
  });

  it("leaves clean output untouched (no banner, no launch line)", () => {
    const pane = "● Hello there.\nSome more output.\n❯";
    assert.equal(stripShellStartup(pane), pane);
  });

  it("never strips noise that appears AFTER real content (only a leading run)", () => {
    const pane = "● Real answer.\nOS: NixOS\nMo Tu We Th Fr Sa Su";
    // First line is not noise → fallback stops immediately, keeps everything.
    assert.equal(stripShellStartup(pane), pane);
  });

  it("strips fastfetch box-art glyph lines in the fallback path", () => {
    const pane = ["▄▟▙█▛▜▝▀", "▖▗▘▚▞░▒▓", "● answer"].join("\n");
    const out = stripShellStartup(pane);
    assert.equal(out, "● answer");
  });
});
