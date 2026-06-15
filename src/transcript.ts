import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sleep } from "./sleep.js";
import type { StopHookPayload } from "./stop-hook.js";

const TURN_END_REASONS = new Set(["end_turn", "max_tokens", "stop_sequence"]);
const DEFAULT_WAIT_MS = 5_000;

export interface TranscriptCompletion {
  readonly transcriptPath: string;
  readonly text: string;
  readonly stopReason: string | null;
  readonly usage: Record<string, number> | null;
  readonly assistantTurns: number;
}

interface AssistantRecord {
  readonly text: string;
  readonly stopReason: string | null;
  readonly usage: Record<string, number> | null;
}

export async function waitForTranscriptCompletion(
  payload: StopHookPayload,
  sessionId: string,
  signal: AbortSignal,
  opts: { claudeConfigDir?: string; waitMs?: number } = {},
): Promise<TranscriptCompletion> {
  const transcriptPath =
    typeof payload.transcript_path === "string" && payload.transcript_path.length > 0
      ? payload.transcript_path
      : await findTranscriptPath(sessionId, opts.claudeConfigDir, signal, opts.waitMs);

  const deadline = Date.now() + (opts.waitMs ?? DEFAULT_WAIT_MS);
  let lastError: Error | null = null;
  while (Date.now() < deadline) {
    const parsed = await parseTranscript(transcriptPath).catch((err) => {
      lastError = err instanceof Error ? err : new Error(String(err));
      return null;
    });
    if (parsed && parsed.stopReason && TURN_END_REASONS.has(parsed.stopReason)) {
      return { transcriptPath, ...parsed };
    }
    await sleep(50, signal);
  }
  throw lastError ?? new Error(`Transcript did not reach a terminal assistant message: ${transcriptPath}`);
}

export async function findTranscriptPath(
  sessionId: string,
  claudeConfigDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"),
  signal?: AbortSignal,
  waitMs = 60_000,
): Promise<string> {
  const projectsDir = path.join(claudeConfigDir, "projects");
  // Scan project subdirs by exact filename instead of a glob — `sessionId` is
  // interpolated, so a glob would treat any `*?[]{}` in it as a pattern.
  const target = `${sessionId}.jsonl`;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const entries = await readdir(projectsDir, { withFileTypes: true }).catch(
      (err) => {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        return [];
      },
    );
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(projectsDir, entry.name, target);
      const found = await stat(candidate).then(
        (s) => s.isFile(),
        () => false,
      );
      if (found) return candidate;
    }
    await sleep(100, signal);
  }
  throw new Error(`Claude transcript not found for session ${sessionId} under ${projectsDir}`);
}

export async function parseTranscript(transcriptPath: string): Promise<Omit<TranscriptCompletion, "transcriptPath">> {
  await stat(transcriptPath);
  const raw = await readFile(transcriptPath, "utf-8");
  const assistants: AssistantRecord[] = [];
  const usageTotals: Record<string, number> = {};

  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    let data: unknown;
    try {
      data = JSON.parse(line);
    } catch {
      continue;
    }
    const assistant = parseAssistantRecord(data);
    if (!assistant) continue;
    assistants.push(assistant);
    if (assistant.usage) {
      for (const [key, value] of Object.entries(assistant.usage)) {
        usageTotals[key] = (usageTotals[key] ?? 0) + value;
      }
    }
  }

  const last = assistants[assistants.length - 1];
  if (!last) {
    return { text: "", stopReason: null, usage: null, assistantTurns: 0 };
  }
  return {
    text: last.text,
    stopReason: last.stopReason,
    usage: Object.keys(usageTotals).length > 0 ? usageTotals : null,
    assistantTurns: assistants.length,
  };
}

function parseAssistantRecord(data: unknown): AssistantRecord | null {
  if (!data || typeof data !== "object") return null;
  const rec = data as Record<string, unknown>;
  if (rec.type !== "assistant") return null;
  const message = isRecord(rec.message) ? rec.message : rec;
  const content = Array.isArray(message.content) ? message.content : [];
  const texts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      texts.push(block.text);
    }
  }
  return {
    text: texts.join("\n"),
    stopReason: typeof message.stop_reason === "string" ? message.stop_reason : null,
    usage: parseUsage(message.usage),
  };
}

function parseUsage(raw: unknown): Record<string, number> | null {
  if (!isRecord(raw)) return null;
  const usage: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "number" && Number.isFinite(value)) usage[key] = value;
  }
  return Object.keys(usage).length > 0 ? usage : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
