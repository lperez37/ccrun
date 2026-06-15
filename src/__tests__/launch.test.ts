import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLaunchCommand, CLAUDE_ENV_STRIP_VARS } from "../launch.js";

test("buildLaunchCommand never includes -p or --max-turns", () => {
  const cmd = buildLaunchCommand({ model: "claude-sonnet-4-6" });
  assert.ok(!/\s-p\b/.test(cmd), "must not contain -p");
  assert.ok(!cmd.includes("--max-turns"), "must not contain --max-turns");
});

test("buildLaunchCommand strips inherited tmux/claude env markers", () => {
  const cmd = buildLaunchCommand({ model: "claude-sonnet-4-6" });
  for (const v of CLAUDE_ENV_STRIP_VARS) {
    assert.ok(cmd.includes(`-u ${v}`), `must strip ${v}`);
  }
  assert.ok(cmd.includes("TERM=xterm-256color"));
});

test("buildLaunchCommand includes model, skip-permissions on by default", () => {
  const cmd = buildLaunchCommand({ model: "claude-opus-4-8" });
  assert.ok(cmd.includes("--model claude-opus-4-8"));
  assert.ok(cmd.includes("--dangerously-skip-permissions"));
});

test("buildLaunchCommand omits skip-permissions when disabled", () => {
  const cmd = buildLaunchCommand({ model: "m", skipPermissions: false });
  assert.ok(!cmd.includes("--dangerously-skip-permissions"));
});

test("buildLaunchCommand includes plugin-dir and settings only when set", () => {
  const bare = buildLaunchCommand({ model: "m" });
  assert.ok(!bare.includes("--plugin-dir"));
  assert.ok(!bare.includes("--settings"));

  const full = buildLaunchCommand({
    model: "m",
    pluginDir: "/opt/plugins",
    settingsPath: "/tmp/x/settings.json",
  });
  assert.ok(full.includes("--plugin-dir /opt/plugins"));
  assert.ok(full.includes("--settings /tmp/x/settings.json"));
});
