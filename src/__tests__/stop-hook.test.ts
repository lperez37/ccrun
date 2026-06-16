import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  buildStopHookSettings,
  cleanupStopHookArtifacts,
  createStopHookArtifacts,
  waitForStopHook,
} from "../stop-hook.js";

const execFileAsync = promisify(execFile);

describe("Stop hook artifacts", () => {
  it("builds a fixed Stop command that shell-quotes the stop path", () => {
    const settings = buildStopHookSettings(
      "/tmp/path with ' quote/stop.jsonl",
      "/tmp/path with ' quote/cost.json",
    );
    const hooks = (settings.hooks as Record<string, unknown>).Stop as Array<{
      hooks: Array<{ type: string; command: string }>;
    }>;
    assert.equal(hooks[0].hooks[0].type, "command");
    assert.equal(
      hooks[0].hooks[0].command,
      "cat >> '/tmp/path with '" + '"' + "'" + '"' + "' quote/stop.jsonl'",
    );
    // The injected statusLine overwrites the cost file (shell-quoted path).
    const statusLine = settings.statusLine as { type: string; command: string };
    assert.equal(statusLine.type, "command");
    assert.equal(
      statusLine.command,
      "cat > '/tmp/path with '" + '"' + "'" + '"' + "' quote/cost.json'",
    );
  });

  it("creates a private artifact dir and a clean append-only stop file", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "ccr-stop-"));
    const artifacts = await createStopHookArtifacts(workspace, "session-1");
    assert.equal(path.dirname(artifacts.stopPath), artifacts.dir);
    assert.equal(path.basename(artifacts.stopPath), "stop.jsonl");
    assert.ok(artifacts.settingsJson.includes("Stop"));
    await cleanupStopHookArtifacts(artifacts);
  });

  it("clears a leftover stop file from a previous run", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "ccr-stop-"));
    const stale = await createStopHookArtifacts(workspace, "session-1");
    await writeFile(stale.stopPath, '{"stale":true}\n');
    const fresh = await createStopHookArtifacts(workspace, "session-1");
    await assert.rejects(readFile(fresh.stopPath), /ENOENT/);
    await cleanupStopHookArtifacts(fresh);
  });
});

describe("waitForStopHook", () => {
  it("returns the first complete JSON payload appended by the hook", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "ccr-stop-"));
    const { stopPath } = await createStopHookArtifacts(workspace, "session-1");
    const controller = new AbortController();
    const waiter = waitForStopHook(stopPath, controller.signal, { pollMs: 10 });
    await appendFile(stopPath, '{"transcript_path":"/t/x.jsonl","session_id":"s"}\n');
    const payload = await waiter;
    assert.equal(payload.transcript_path, "/t/x.jsonl");
    assert.equal(payload.session_id, "s");
  });

  it("only consumes the FIRST payload when several Stop events append", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "ccr-stop-"));
    const { stopPath } = await createStopHookArtifacts(workspace, "session-1");
    await appendFile(stopPath, '{"n":1}\n{"n":2}\n{"n":3}\n');
    const payload = await waitForStopHook(stopPath, new AbortController().signal, {
      pollMs: 10,
    });
    assert.equal(payload.n, 1);
  });

  it("REGRESSION: repeated `cat >> file` Stop writes never block the writer", async () => {
    // The old FIFO transport blocked the 2nd `cat >> fifo` (no reader) until the
    // 600s hook timeout, stalling the agent. A regular file must never block.
    const workspace = await mkdtemp(path.join(tmpdir(), "ccr-stop-"));
    const { stopPath } = await createStopHookArtifacts(workspace, "session-1");
    // First Stop event consumed by the runner; the reader then goes away.
    await appendFile(stopPath, '{"event":1}\n');
    await waitForStopHook(stopPath, new AbortController().signal, { pollMs: 10 });
    // Second Stop event with NO reader present — must complete immediately.
    const started = process.hrtime.bigint();
    await execFileAsync("bash", ["-c", `printf '%s\\n' '{"event":2}' | cat >> ${JSON.stringify(stopPath)}`]);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(elapsedMs < 2000, `2nd Stop write blocked for ${elapsedMs}ms`);
    const contents = await readFile(stopPath, "utf-8");
    assert.match(contents, /"event":2/);
    await cleanupStopHookArtifacts({
      dir: path.dirname(stopPath),
      stopPath,
      costPath: path.join(path.dirname(stopPath), "cost.json"),
      settingsPath: "",
      settingsJson: "",
    });
  });

  it("aborts cleanly when the signal fires before any payload", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "ccr-stop-"));
    const { stopPath } = await createStopHookArtifacts(workspace, "session-1");
    const controller = new AbortController();
    const waiter = waitForStopHook(stopPath, controller.signal, { pollMs: 10 });
    controller.abort(new Error("cancelled"));
    await assert.rejects(waiter, /cancelled/);
  });
});
