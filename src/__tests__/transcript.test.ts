import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  findTranscriptPath,
  parseTranscript,
  waitForTranscriptCompletion,
} from "../transcript.js";

function assistant(text: string, stopReason: string, usage = {}) {
  return JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "text", text }],
      stop_reason: stopReason,
      usage,
    },
  });
}

describe("Claude transcript parsing", () => {
  it("finds transcripts under projects subdirectories", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ccr-transcript-"));
    const project = path.join(root, "projects", "encoded-cwd");
    await mkdir(project, { recursive: true });
    const transcript = path.join(project, "session-1.jsonl");
    await writeFile(transcript, `${assistant("done", "end_turn")}\n`);
    assert.equal(await findTranscriptPath("session-1", root, undefined, 100), transcript);
  });

  it("parses assistant text, terminal stop reason, and usage totals", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ccr-transcript-"));
    const transcript = path.join(root, "session.jsonl");
    await writeFile(
      transcript,
      [
        "{bad json",
        assistant("first", "tool_use", { input_tokens: 2 }),
        JSON.stringify({ type: "system", message: "after assistant" }),
        assistant("final", "end_turn", { input_tokens: 3, output_tokens: 4 }),
        "",
      ].join("\n"),
    );
    const parsed = await parseTranscript(transcript);
    assert.equal(parsed.text, "final");
    assert.equal(parsed.stopReason, "end_turn");
    assert.deepEqual(parsed.usage, { input_tokens: 5, output_tokens: 4 });
    assert.equal(parsed.assistantTurns, 2);
  });

  it("waits for a terminal assistant stop reason", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ccr-transcript-"));
    const transcript = path.join(root, "session.jsonl");
    await writeFile(transcript, `${assistant("final", "stop_sequence")}\n`);
    const controller = new AbortController();
    const result = await waitForTranscriptCompletion(
      { transcript_path: transcript },
      "session",
      controller.signal,
      { waitMs: 100 },
    );
    assert.equal(result.text, "final");
    assert.equal(result.stopReason, "stop_sequence");
  });
});
