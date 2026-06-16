import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCostPayload } from "../session-cost.js";

describe("parseCostPayload", () => {
  it("reads cost.total_cost_usd from the statusLine payload", () => {
    const payload = JSON.stringify({
      session_id: "abc",
      model: { id: "claude-opus-4-8", display_name: "Opus 4.8" },
      workspace: { current_dir: "/tmp" },
      cost: { total_cost_usd: 0.082, total_duration_ms: 1234, total_lines_added: 3 },
    });
    assert.equal(parseCostPayload(payload), 0.082);
  });

  it("handles a zero cost", () => {
    assert.equal(parseCostPayload(JSON.stringify({ cost: { total_cost_usd: 0 } })), 0);
  });

  it("returns null for missing/non-numeric cost or bad JSON", () => {
    assert.equal(parseCostPayload(JSON.stringify({ model: { id: "x" } })), null);
    assert.equal(parseCostPayload(JSON.stringify({ cost: {} })), null);
    assert.equal(parseCostPayload(JSON.stringify({ cost: { total_cost_usd: "1.0" } })), null);
    assert.equal(parseCostPayload("{not json"), null);
    assert.equal(parseCostPayload(""), null);
  });
});
