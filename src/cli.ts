#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import { createRequire } from "node:module";

import { makeLogger, type LogLevel } from "./logger.js";
import { run, type RunResult } from "./run.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const DEFAULT_MODEL = "claude-sonnet-4-6";
const MODEL_ALIASES: Record<string, string> = {
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-8",
  haiku: "claude-haiku-4-5-20251001",
};

const HELP = `ccrun — run one interactive Claude Code turn inside tmux (subscription pool)

USAGE
  ccrun [options] "<prompt>"
  ccrun [options] < prompt.txt      # prompt read from stdin when no argument

OPTIONS
  --model <m>          Model id or alias (sonnet|opus|haiku). Default: ${DEFAULT_MODEL}
  --cwd <dir>          Working directory for the run. Default: current directory
  --timeout <seconds>  Hard cap on the run. Default: 1800
  --plugin-dir <dir>   Passed to 'claude --plugin-dir' when set
  --json               Emit a JSON result object on stdout instead of plain text
  --no-skip-permissions  Drop --dangerously-skip-permissions (will block on prompts)
  --quiet              Suppress diagnostics on stderr
  --verbose            Verbose diagnostics on stderr
  -h, --help           Show this help
  -v, --version        Show version

OUTPUT
  stdout = the final assistant message (or JSON with --json). stderr = diagnostics.
  exit 0 success · 1 failure · 2 usage error · 124 timeout · 130 interrupted.

REQUIREMENTS
  Node >= 22, tmux, and the 'claude' CLI logged in to an interactive subscription.
`;

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        model: { type: "string" },
        cwd: { type: "string" },
        timeout: { type: "string" },
        "plugin-dir": { type: "string" },
        json: { type: "boolean", default: false },
        "skip-permissions": { type: "boolean", default: true },
        quiet: { type: "boolean", default: false },
        verbose: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    });
  } catch (err) {
    process.stderr.write(`ccrun: ${err instanceof Error ? err.message : String(err)}\n`);
    process.stderr.write(`Run 'ccrun --help' for usage.\n`);
    return 2;
  }

  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${version}\n`);
    return 0;
  }

  const level: LogLevel = values.quiet ? "error" : values.verbose ? "debug" : "info";
  const logger = makeLogger(level);

  // Prompt: positional arg(s) win; otherwise read stdin (supports piping a file).
  let prompt = positionals.join(" ").trim();
  if (prompt.length === 0) prompt = (await readStdin()).trim();
  if (prompt.length === 0) {
    process.stderr.write("ccrun: no prompt given (pass an argument or pipe via stdin).\n");
    process.stderr.write("Run 'ccrun --help' for usage.\n");
    return 2;
  }

  const timeoutSeconds = values.timeout ? Number(values.timeout) : 1800;
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    process.stderr.write(`ccrun: invalid --timeout '${values.timeout}'.\n`);
    return 2;
  }

  const rawModel = values.model ?? DEFAULT_MODEL;
  const model = MODEL_ALIASES[rawModel] ?? rawModel;

  // Preflight: fail fast with an actionable message if the toolchain is missing.
  const missing = await preflight();
  if (missing.length > 0) {
    process.stderr.write(`ccrun: missing required tool(s): ${missing.join(", ")}.\n`);
    process.stderr.write(
      "Install them and ensure 'claude' is logged in to an interactive subscription.\n",
    );
    return 2;
  }

  // Signal handling: a single SIGINT/SIGTERM aborts the run; run() reclaims the
  // tmux session in its finally block. Exit 130 (SIGINT convention).
  const controller = new AbortController();
  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
    logger.warn("interrupted — reclaiming tmux session");
    controller.abort(new Error("canceled"));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  let result: RunResult;
  try {
    result = await run({
      prompt,
      model,
      cwd: values.cwd ?? process.cwd(),
      timeoutSeconds,
      pluginDir: values["plugin-dir"],
      skipPermissions: values["skip-permissions"],
      signal: controller.signal,
      logger,
    });
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }

  if (values.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    process.stdout.write(result.result);
    if (!result.result.endsWith("\n")) process.stdout.write("\n");
    if (result.status !== "succeeded") {
      process.stderr.write(`ccrun: run ${result.status}${result.error ? `: ${result.error}` : ""}\n`);
    }
  }

  if (interrupted && result.status !== "succeeded") return 130;
  return result.exitCode;
}

/**
 * Check that tmux and claude are resolvable on PATH. Returns missing names.
 * We only care whether the binary EXISTS, not whether the probe flag succeeds
 * (tmux uses `-V`, not `--version`), so only ENOENT counts as missing — any
 * other failure means the binary ran.
 */
async function preflight(): Promise<string[]> {
  const missing: string[] = [];
  const probes: Record<string, string> = { tmux: "-V", claude: "--version" };
  for (const [bin, flag] of Object.entries(probes)) {
    const present = await execFileAsync(bin, [flag]).then(
      () => true,
      (err: NodeJS.ErrnoException) => err.code !== "ENOENT",
    );
    if (!present) missing.push(bin);
  }
  return missing;
}

function readStdin(): Promise<string> {
  // Only read if stdin is piped/redirected; a TTY would block forever.
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`ccrun: fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  },
);
