import { test } from "node:test";
import assert from "node:assert/strict";
import { reclaimSession } from "../kill.js";
import type { Tmux } from "../tmux.js";
import { makeLogger } from "../logger.js";

const silent = makeLogger("silent");

/**
 * A fake Tmux that records calls and goes "gone" after a configurable step.
 * `aliveUntil` is the number of hasSession() probes that still report alive;
 * after that many probes, the session is considered gone.
 */
function fakeTmux(opts: { goneAfterCalls?: number; pids?: number[] } = {}) {
  const calls: string[] = [];
  let probes = 0;
  const goneAfter = opts.goneAfterCalls ?? Infinity;
  const tmux = {
    hasSession: async () => {
      const alive = probes < goneAfter;
      probes += 1;
      calls.push(`hasSession:${alive}`);
      return alive;
    },
    listPanePids: async () => {
      calls.push("listPanePids");
      return opts.pids ?? [];
    },
    sendKeysLiteral: async (_n: string, t: string) => {
      calls.push(`sendKeysLiteral:${t}`);
    },
    sendEnter: async () => calls.push("sendEnter"),
    sendCtrlC: async () => calls.push("sendCtrlC"),
    killSession: async () => {
      calls.push("killSession");
      return true;
    },
  } as unknown as Tmux;
  return { tmux, calls };
}

test("reclaimSession no-ops when the session is already gone", async () => {
  const { tmux, calls } = fakeTmux({ goneAfterCalls: 0 });
  await reclaimSession("ccr-x", { tmux, logger: silent });
  assert.deepEqual(calls, ["hasSession:false"]);
});

test("reclaimSession stops at graceful /exit when session exits", async () => {
  // alive on initial probe, gone on the post-/exit probe.
  const { tmux, calls } = fakeTmux({ goneAfterCalls: 1 });
  await reclaimSession("ccr-x", { tmux, logger: silent, config: { gentleWaitMs: 0 } });
  assert.ok(calls.includes("sendKeysLiteral:/exit"));
  assert.ok(calls.includes("sendEnter"));
  assert.ok(!calls.includes("sendCtrlC"), "should not escalate to C-c");
  assert.ok(!calls.includes("killSession"), "should not escalate to kill-session");
});

test("reclaimSession escalates to kill-session when /exit and C-c fail", async () => {
  // Stays alive through /exit and C-c probes, gone after kill-session probe.
  const { tmux, calls } = fakeTmux({ goneAfterCalls: 3 });
  await reclaimSession("ccr-x", {
    tmux,
    logger: silent,
    config: { gentleWaitMs: 0, interruptWaitMs: 0 },
  });
  assert.ok(calls.includes("sendCtrlC"));
  assert.ok(calls.includes("killSession"));
});

test("reclaimSession SIGTERM/SIGKILLs pane pids when tmux is wedged", async () => {
  const { tmux, calls } = fakeTmux({ goneAfterCalls: Infinity, pids: [4242] });
  const signals: Array<{ pid: number; sig: string }> = [];
  await reclaimSession("ccr-x", {
    tmux,
    logger: silent,
    config: { gentleWaitMs: 0, interruptWaitMs: 0 },
    killPid: (pid, sig) => signals.push({ pid, sig }),
  });
  assert.deepEqual(signals, [
    { pid: 4242, sig: "SIGTERM" },
    { pid: 4242, sig: "SIGKILL" },
  ]);
});
