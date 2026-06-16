import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSessionCostUsd } from "../session-cost.js";

describe("parseSessionCostUsd", () => {
  it("reads the cost from the status footer", () => {
    const pane = [
      "● POLL_OK",
      "",
      "────────────────────────────────────",
      "❯ ",
      "────────────────────────────────────",
      "   /tmp │ 󰊠 Sonnet 4.6 │ $0.082 │ █░░░░░░░░░ 15%        30241 tokens",
      "  ⏵⏵ bypass permissions on",
    ].join("\n");
    assert.equal(parseSessionCostUsd(pane), 0.082);
  });

  it("handles a footer with a title segment and whole-dollar cost", () => {
    const pane = '/home/x │ Opus 4.8 │ "fix bug" │ $12 │ ██░ 40%  120000 tokens';
    assert.equal(parseSessionCostUsd(pane), 12);
  });

  it("returns null when no cost is shown", () => {
    assert.equal(parseSessionCostUsd("❯ hello\n──────\n  some output 5 tokens"), null);
    assert.equal(parseSessionCostUsd("no footer here"), null);
  });

  it("prefers the footer line (with tokens) over an incidental $ in output", () => {
    const pane = [
      "● The price is $5.00 in the answer text",
      "   /tmp │ Sonnet 4.6 │ $0.013 │ █░ 8%  2000 tokens",
    ].join("\n");
    assert.equal(parseSessionCostUsd(pane), 0.013);
  });
});
