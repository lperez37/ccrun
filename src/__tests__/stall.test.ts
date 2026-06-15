import { test } from "node:test";
import assert from "node:assert/strict";
import { StallWatchdog } from "../stall.js";

test("StallWatchdog fires after stallMs of unchanged non-working signature", () => {
  let now = 0;
  const wd = new StallWatchdog({ stallMs: 1000, now: () => now });
  assert.equal(wd.observe("sig-a", "idle"), false); // anchor
  now = 500;
  assert.equal(wd.observe("sig-a", "idle"), false);
  now = 1000;
  assert.equal(wd.observe("sig-a", "idle"), true); // 1000ms stable → stalled
});

test("StallWatchdog resets on working phase", () => {
  let now = 0;
  const wd = new StallWatchdog({ stallMs: 1000, now: () => now });
  wd.observe("sig-a", "idle");
  now = 999;
  assert.equal(wd.observe("sig-a", "working"), false); // working resets the anchor
  now = 1500;
  assert.equal(wd.observe("sig-a", "idle"), false); // anchor moved to t=999
  now = 1999;
  assert.equal(wd.observe("sig-a", "idle"), true);
});

test("StallWatchdog resets when signature changes", () => {
  let now = 0;
  const wd = new StallWatchdog({ stallMs: 1000, now: () => now });
  wd.observe("sig-a", "idle");
  now = 900;
  assert.equal(wd.observe("sig-b", "idle"), false); // new signature → new anchor
  now = 1899;
  assert.equal(wd.observe("sig-b", "idle"), false);
  now = 1900;
  assert.equal(wd.observe("sig-b", "idle"), true);
});

test("StallWatchdog stableForMs reflects elapsed since anchor", () => {
  let now = 100;
  const wd = new StallWatchdog({ stallMs: 1000, now: () => now });
  wd.observe("sig-a", "idle");
  now = 700;
  assert.equal(wd.stableForMs(), 600);
  wd.reset();
  assert.equal(wd.stableForMs(), 0);
});
