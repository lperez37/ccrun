/**
 * Tiny stderr logger. Replaces the v2 server's winston dependency so the CLI
 * ships with zero runtime deps.
 *
 * CRITICAL: every diagnostic goes to STDERR. stdout is reserved for the run's
 * result (the final assistant message, or `--json`) so `ccrun` is pipeable and
 * composable — e.g. `out=$(ccrun "...")`.
 */

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

const ORDER: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

export interface Logger {
  error(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
}

function format(level: string, msg: string, meta?: Record<string, unknown>): string {
  const tail =
    meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : "";
  return `[ccrun] ${level} ${msg}${tail}\n`;
}

/** Build a logger that emits to stderr at or below `level`. */
export function makeLogger(level: LogLevel): Logger {
  const threshold = ORDER[level];
  const emit = (lvl: LogLevel, msg: string, meta?: Record<string, unknown>): void => {
    if (ORDER[lvl] > threshold) return;
    process.stderr.write(format(lvl, msg, meta));
  };
  return {
    error: (m, meta) => emit("error", m, meta),
    warn: (m, meta) => emit("warn", m, meta),
    info: (m, meta) => emit("info", m, meta),
    debug: (m, meta) => emit("debug", m, meta),
  };
}
