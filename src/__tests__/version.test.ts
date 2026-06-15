import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isTunedVersion,
  parseClaudeVersion,
  TUNED_CLAUDE_CODE_VERSION,
} from "../version.js";

test("parseClaudeVersion extracts a semver from claude --version output", () => {
  assert.equal(parseClaudeVersion("2.1.178 (Claude Code)"), "2.1.178");
  assert.equal(parseClaudeVersion("claude 2.1.0\n"), "2.1.0");
  assert.equal(parseClaudeVersion("no version here"), null);
});

test("isTunedVersion accepts same major.minor (patch drift is fine)", () => {
  assert.equal(isTunedVersion("2.1.178", "2.1.178"), true);
  assert.equal(isTunedVersion("2.1.200", "2.1.178"), true);
  assert.equal(isTunedVersion("2.1.0", "2.1.178"), true);
});

test("isTunedVersion flags a different minor or major as drift", () => {
  assert.equal(isTunedVersion("2.2.0", "2.1.178"), false);
  assert.equal(isTunedVersion("3.0.0", "2.1.178"), false);
  assert.equal(isTunedVersion(null, "2.1.178"), false);
});

test("TUNED_CLAUDE_CODE_VERSION is a concrete semver", () => {
  assert.match(TUNED_CLAUDE_CODE_VERSION, /^\d+\.\d+\.\d+$/);
});
