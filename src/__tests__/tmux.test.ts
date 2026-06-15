import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import {
  defaultSessionPath,
  makeTmux,
  parseSessionList,
  parsePanePids,
  type Exec,
  type ExecResult,
  type Keystroke,
} from "../tmux.js";

const HOME = os.homedir();

/** A recorded tmux invocation: the file and its argv. */
interface Call {
  readonly file: string;
  readonly args: readonly string[];
}

/**
 * Build a stub exec seam that records every call and returns canned output.
 * `responses` maps the FIRST arg (the tmux subcommand) to a result or an
 * Error to throw. Anything not listed returns empty stdout/stderr.
 */
function makeStubExec(
  responses: Record<string, ExecResult | Error> = {},
): { exec: Exec; calls: Call[] } {
  const calls: Call[] = [];
  const exec: Exec = async (file, args) => {
    calls.push({ file, args: [...args] });
    const key = args[0] ?? "";
    const planned = responses[key];
    if (planned instanceof Error) throw planned;
    return planned ?? { stdout: "", stderr: "" };
  };
  return { exec, calls };
}

const EMPTY: ExecResult = { stdout: "", stderr: "" };

describe("tmux argv construction", () => {
  it("newSession boots a clean no-rc shell with explicit PATH, then pins escape-time", async () => {
    const { exec, calls } = makeStubExec();
    const t = makeTmux(exec);
    await t.newSession("ccr-owl-1", "/work/app", { path: "/usr/bin:/bin" });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].file, "tmux");
    // Clean shell + explicit PATH (TASK 0): tmux starts `bash --norc --noprofile`
    // running a -c that exports the explicit PATH then execs an interactive no-rc
    // bash. This keeps the login-shell fastfetch banner from running AND forces
    // PATH regardless of the tmux server's inherited environment.
    assert.deepEqual(calls[0].args, [
      "new-session",
      "-d",
      "-s",
      "ccr-owl-1",
      "-c",
      "/work/app",
      "bash",
      "--norc",
      "--noprofile",
      "-c",
      "export PATH='/usr/bin:/bin'; exec bash --norc --noprofile",
    ]);
    // Belt-and-suspenders escape-time pin, scoped to this session only.
    assert.deepEqual(calls[1].args, [
      "set-option",
      "-t",
      "ccr-owl-1",
      "escape-time",
      "10",
    ]);
  });

  it("newSession defaults to defaultSessionPath() when no path override is given", async () => {
    const { exec, calls } = makeStubExec();
    const t = makeTmux(exec);
    await t.newSession("ccr-owl-3", "/work/app");
    const args = calls[0].args;
    // The boot shell is the last argument; it must export the default PATH.
    const bootShell = args[args.length - 1];
    assert.ok(bootShell.startsWith(`export PATH='${defaultSessionPath()}'`));
    assert.ok(bootShell.endsWith("exec bash --norc --noprofile"));
    // The outer shell is still the clean no-rc bash, with the -c boot shell last.
    assert.deepEqual(args.slice(-5, -1), ["bash", "--norc", "--noprofile", "-c"]);
  });

  it("newSession tolerates a set-option failure (older tmux) without throwing", async () => {
    const { exec } = makeStubExec({
      "set-option": new Error("unknown option: escape-time"),
    });
    const t = makeTmux(exec);
    // Must resolve — a rejected escape-time pin is non-fatal.
    await t.newSession("ccr-owl-2", "/work/app", { path: "/usr/bin:/bin" });
  });

  it("pins every invocation to the private socket via -L when a socket is given", async () => {
    const { exec, calls } = makeStubExec({ "has-session": EMPTY });
    const t = makeTmux(exec, "ccrun-1a2b3c4d");
    await t.sendEnter("ccr-x");
    await t.hasSession("ccr-x");
    // -L <socket> is prepended to EVERY tmux argv, isolating this run's server.
    assert.deepEqual(calls[0].args.slice(0, 4), ["-L", "ccrun-1a2b3c4d", "send-keys", "-t"]);
    assert.deepEqual(calls[1].args.slice(0, 3), ["-L", "ccrun-1a2b3c4d", "has-session"]);
  });

  it("omits -L entirely when no socket is given (default server)", async () => {
    const { exec, calls } = makeStubExec();
    const t = makeTmux(exec);
    await t.sendEnter("ccr-x");
    assert.equal(calls[0].args[0], "send-keys");
    assert.ok(!calls[0].args.includes("-L"));
  });

  it("sendKeysLiteral uses -l literal flag and -- terminator", async () => {
    const { exec, calls } = makeStubExec();
    const t = makeTmux(exec);
    await t.sendKeysLiteral("ccr-x", "-rf weird text");
    assert.deepEqual(calls[0].args, [
      "send-keys",
      "-t",
      "ccr-x",
      "-l",
      "--",
      "-rf weird text",
    ]);
  });

  it("sendKeysLiteral escapes a standalone semicolon token (tmux drops a bare ;)", async () => {
    const { exec, calls } = makeStubExec();
    const t = makeTmux(exec);
    await t.sendKeysLiteral("ccr-x", ";");
    assert.deepEqual(calls[0].args, ["send-keys", "-t", "ccr-x", "-l", "--", "\\;"]);
  });

  it("sendKeysLiteral escapes a run of semicolons (;;)", async () => {
    const { exec, calls } = makeStubExec();
    const t = makeTmux(exec);
    await t.sendKeysLiteral("ccr-x", ";;");
    assert.deepEqual(calls[0].args, [
      "send-keys",
      "-t",
      "ccr-x",
      "-l",
      "--",
      "\\;\\;",
    ]);
  });

  it("sendKeysLiteral does NOT escape a semicolon embedded in a larger token", async () => {
    // tmux only treats a bare-`;` token as a separator; embedded `;` is literal.
    const { exec, calls } = makeStubExec();
    const t = makeTmux(exec);
    await t.sendKeysLiteral("ccr-x", "a ; b && c");
    assert.deepEqual(calls[0].args, [
      "send-keys",
      "-t",
      "ccr-x",
      "-l",
      "--",
      "a ; b && c",
    ]);
  });

  it("sendEnter sends the Enter key name (no -l)", async () => {
    const { exec, calls } = makeStubExec();
    const t = makeTmux(exec);
    await t.sendEnter("ccr-x");
    assert.deepEqual(calls[0].args, ["send-keys", "-t", "ccr-x", "Enter"]);
  });

  it("sendCtrlC sends C-c", async () => {
    const { exec, calls } = makeStubExec();
    const t = makeTmux(exec);
    await t.sendCtrlC("ccr-x");
    assert.deepEqual(calls[0].args, ["send-keys", "-t", "ccr-x", "C-c"]);
  });

  it("capturePane uses -p -e -J and default -S -5000", async () => {
    const { exec, calls } = makeStubExec({
      "capture-pane": { stdout: "pane text", stderr: "" },
    });
    const t = makeTmux(exec);
    const out = await t.capturePane("ccr-x");
    assert.equal(out, "pane text");
    assert.deepEqual(calls[0].args, [
      "capture-pane",
      "-t",
      "ccr-x",
      "-p",
      "-e",
      "-J",
      "-S",
      "-5000",
    ]);
  });

  it("capturePane honors a custom line count", async () => {
    const { exec, calls } = makeStubExec({ "capture-pane": EMPTY });
    const t = makeTmux(exec);
    await t.capturePane("ccr-x", 120);
    assert.deepEqual(calls[0].args, [
      "capture-pane",
      "-t",
      "ccr-x",
      "-p",
      "-e",
      "-J",
      "-S",
      "-120",
    ]);
  });

  it("pipePaneToFile streams pane output to a single-quoted file via cat >>", async () => {
    const { exec, calls } = makeStubExec();
    const t = makeTmux(exec);
    await t.pipePaneToFile("ccr-owl", "/tmp/ws/stream.log");
    assert.deepEqual(calls[0].args, [
      "pipe-pane",
      "-o",
      "-t",
      "ccr-owl",
      "cat >> '/tmp/ws/stream.log'",
    ]);
  });

  it("loadBuffer uses a per-session named buffer and a file path", async () => {
    const { exec, calls } = makeStubExec();
    const t = makeTmux(exec);
    await t.loadBuffer("ccr-owl", "/tmp/ws/prompt.txt");
    assert.deepEqual(calls[0].args, [
      "load-buffer",
      "-b",
      "ccr-owl",
      "/tmp/ws/prompt.txt",
    ]);
  });

  it("pasteBuffer requests bracketed paste (-p) and targets buffer + session", async () => {
    const { exec, calls } = makeStubExec();
    const t = makeTmux(exec);
    await t.pasteBuffer("ccr-owl", "ccr-owl");
    assert.deepEqual(calls[0].args, [
      "paste-buffer",
      "-p",
      "-b",
      "ccr-owl",
      "-t",
      "ccr-owl",
    ]);
  });

  it("listSessions requests the activity+attached format", async () => {
    const { exec, calls } = makeStubExec({ "list-sessions": EMPTY });
    const t = makeTmux(exec);
    await t.listSessions("ccr-");
    assert.deepEqual(calls[0].args, [
      "list-sessions",
      "-F",
      "#{session_name} #{session_activity} #{session_attached}",
    ]);
  });

  it("listPanePids requests the pane_pid format", async () => {
    const { exec, calls } = makeStubExec({ "list-panes": EMPTY });
    const t = makeTmux(exec);
    await t.listPanePids("ccr-x");
    assert.deepEqual(calls[0].args, [
      "list-panes",
      "-t",
      "ccr-x",
      "-F",
      "#{pane_pid}",
    ]);
  });

  it("killSession targets the session", async () => {
    const { exec, calls } = makeStubExec();
    const t = makeTmux(exec);
    const killed = await t.killSession("ccr-x");
    assert.equal(killed, true);
    assert.deepEqual(calls[0].args, ["kill-session", "-t", "ccr-x"]);
  });
});

describe("hasSession", () => {
  it("returns true when has-session succeeds", async () => {
    const { exec } = makeStubExec({ "has-session": EMPTY });
    const t = makeTmux(exec);
    assert.equal(await t.hasSession("ccr-x"), true);
  });

  it("returns false when has-session throws", async () => {
    const { exec } = makeStubExec({
      "has-session": new Error("can't find session: ccr-x"),
    });
    const t = makeTmux(exec);
    assert.equal(await t.hasSession("ccr-x"), false);
  });
});

describe("graceful session-not-found handling", () => {
  it("killSession returns false (no throw) for a missing session", async () => {
    const { exec } = makeStubExec({
      "kill-session": new Error("can't find session: ccr-gone"),
    });
    const t = makeTmux(exec);
    assert.equal(await t.killSession("ccr-gone"), false);
  });

  it("killSession rethrows non-not-found errors", async () => {
    const { exec } = makeStubExec({
      "kill-session": new Error("permission denied"),
    });
    const t = makeTmux(exec);
    await assert.rejects(t.killSession("ccr-x"), /permission denied/);
  });

  it("capturePane returns empty string for a missing session", async () => {
    const { exec } = makeStubExec({
      "capture-pane": new Error("no such session"),
    });
    const t = makeTmux(exec);
    assert.equal(await t.capturePane("ccr-gone"), "");
  });

  it("listSessions returns [] when no server is running", async () => {
    const { exec } = makeStubExec({
      "list-sessions": new Error("no server running on /tmp/tmux-1000/default"),
    });
    const t = makeTmux(exec);
    assert.deepEqual(await t.listSessions("ccr-"), []);
  });

  it("listPanePids returns [] for a missing session", async () => {
    const { exec } = makeStubExec({
      "list-panes": new Error("can't find session"),
    });
    const t = makeTmux(exec);
    assert.deepEqual(await t.listPanePids("ccr-gone"), []);
  });
});

describe("parseSessionList", () => {
  it("parses well-formed lines and filters by prefix", () => {
    const stdout = [
      "ccr-owl-1 1718460000 0",
      "ccr-cat-2 1718460100 1",
      "work 1718460200 0",
      "ccrtest-zz 1718460300 0",
    ].join("\n");
    const result = parseSessionList(stdout, "ccr-");
    assert.deepEqual(result, [
      { name: "ccr-owl-1", activityEpoch: 1718460000, attached: false },
      { name: "ccr-cat-2", activityEpoch: 1718460100, attached: true },
    ]);
  });

  it("treats any non-zero attached count as attached", () => {
    const result = parseSessionList("ccr-x 100 3", "ccr-");
    assert.equal(result[0].attached, true);
  });

  it("skips malformed lines (too few fields)", () => {
    const stdout = ["ccr-good 100 0", "ccr-bad-noactivity", ""].join("\n");
    const result = parseSessionList(stdout, "ccr-");
    assert.deepEqual(result, [
      { name: "ccr-good", activityEpoch: 100, attached: false },
    ]);
  });

  it("skips lines with non-numeric activity", () => {
    const stdout = ["ccr-x notanumber 0", "ccr-y 200 0"].join("\n");
    const result = parseSessionList(stdout, "ccr-");
    assert.deepEqual(result, [
      { name: "ccr-y", activityEpoch: 200, attached: false },
    ]);
  });

  it("returns [] for empty input", () => {
    assert.deepEqual(parseSessionList("", "ccr-"), []);
    assert.deepEqual(parseSessionList("\n\n", "ccr-"), []);
  });

  it("tolerates extra whitespace between fields", () => {
    const result = parseSessionList("ccr-x   100    0", "ccr-");
    assert.deepEqual(result, [
      { name: "ccr-x", activityEpoch: 100, attached: false },
    ]);
  });

  it("does not match a prefix that is only a substring", () => {
    const result = parseSessionList("myccr-x 100 0", "ccr-");
    assert.deepEqual(result, []);
  });
});

describe("defaultSessionPath", () => {
  it("honors RUNNER_SESSION_PATH override verbatim", () => {
    assert.equal(
      defaultSessionPath({ RUNNER_SESSION_PATH: "/only/this" } as NodeJS.ProcessEnv),
      "/only/this",
    );
  });

  it("prepends the home-based base PATH and appends the inherited PATH", () => {
    const result = defaultSessionPath({ PATH: "/inherited/bin" } as NodeJS.ProcessEnv);
    assert.ok(result.startsWith(`${HOME}/.local/bin:`));
    assert.ok(result.includes("/run/current-system/sw/bin"));
    assert.ok(result.endsWith(":/inherited/bin"));
    // claude lives in ~/.local/bin — must be present so the clean shell finds it.
    assert.ok(result.includes(`${HOME}/.local/bin`));
  });

  it("uses the base PATH alone when no PATH is inherited", () => {
    const result = defaultSessionPath({} as NodeJS.ProcessEnv);
    assert.equal(
      result,
      `${HOME}/.local/bin:${HOME}/.nix-profile/bin:/run/current-system/sw/bin:/usr/local/bin:/usr/bin:/bin`,
    );
  });

  it("ignores an empty RUNNER_SESSION_PATH and falls back to the default", () => {
    const result = defaultSessionPath({
      RUNNER_SESSION_PATH: "",
      PATH: "/x",
    } as NodeJS.ProcessEnv);
    assert.ok(result.startsWith(`${HOME}/.local/bin:`));
    assert.ok(result.endsWith(":/x"));
  });
});

describe("parsePanePids", () => {
  it("parses positive integers, one per line", () => {
    assert.deepEqual(parsePanePids("1234\n5678\n"), [1234, 5678]);
  });

  it("skips blank and non-numeric lines", () => {
    assert.deepEqual(parsePanePids("1234\n\nnotapid\n42"), [1234, 42]);
  });

  it("drops zero and negative values", () => {
    assert.deepEqual(parsePanePids("0\n-5\n7"), [7]);
  });

  it("returns [] for empty input", () => {
    assert.deepEqual(parsePanePids(""), []);
  });
});

describe("humanSendText", () => {
  /** Deterministic producer: yields one keystroke per char with fixed delay. */
  const fixedProducer = function* (text: string): Iterable<Keystroke> {
    for (const ch of text) yield { ch, delayMs: 10 };
  };

  it("sends one literal send-keys per char, sleeping before each", async () => {
    const { exec, calls } = makeStubExec();
    const t = makeTmux(exec);
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
    };

    await t.humanSendText("ccr-x", "ab", undefined, () => 0.5, {
      produce: fixedProducer,
      sleep,
    });

    // Two sleeps (one before each char), two send-keys calls.
    assert.deepEqual(sleeps, [10, 10]);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].args, [
      "send-keys",
      "-t",
      "ccr-x",
      "-l",
      "--",
      "a",
    ]);
    assert.deepEqual(calls[1].args, [
      "send-keys",
      "-t",
      "ccr-x",
      "-l",
      "--",
      "b",
    ]);
  });

  it("passes the abort signal through to sleep", async () => {
    const { exec } = makeStubExec();
    const t = makeTmux(exec);
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const sleep = async (_ms: number, signal?: AbortSignal) => {
      seenSignal = signal;
    };

    await t.humanSendText("ccr-x", "a", undefined, () => 0.5, {
      produce: fixedProducer,
      sleep,
      signal: controller.signal,
    });
    assert.equal(seenSignal, controller.signal);
  });

  it("throws and stops typing when the signal is already aborted", async () => {
    const { exec, calls } = makeStubExec();
    const t = makeTmux(exec);
    const controller = new AbortController();
    controller.abort(new Error("canceled by user"));
    const sleep = async () => {};

    await assert.rejects(
      t.humanSendText("ccr-x", "abc", undefined, () => 0.5, {
        produce: fixedProducer,
        sleep,
        signal: controller.signal,
      }),
      /canceled by user/,
    );
    // Aborted before the first keystroke → nothing sent.
    assert.equal(calls.length, 0);
  });

  it("propagates a reject from sleep (mid-type abort)", async () => {
    const { exec, calls } = makeStubExec();
    const t = makeTmux(exec);
    let sleepCount = 0;
    const sleep = async () => {
      sleepCount += 1;
      if (sleepCount === 2) throw new Error("aborted mid-sleep");
    };

    await assert.rejects(
      t.humanSendText("ccr-x", "abc", undefined, () => 0.5, {
        produce: fixedProducer,
        sleep,
      }),
      /aborted mid-sleep/,
    );
    // First char sent (sleep#1 ok), second sleep rejected before its send.
    assert.equal(calls.length, 1);
  });

  it("sends nothing for empty text", async () => {
    const { exec, calls } = makeStubExec();
    const t = makeTmux(exec);
    let slept = false;
    await t.humanSendText("ccr-x", "", undefined, () => 0.5, {
      produce: fixedProducer,
      sleep: async () => {
        slept = true;
      },
    });
    assert.equal(calls.length, 0);
    assert.equal(slept, false);
  });
});
