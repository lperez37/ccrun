/**
 * Read the session cost from the JSON payload Claude Code passes to a
 * `statusLine` command on stdin. ccrun injects its own statusLine (via the
 * `--settings` file it already controls) that writes this payload to a file, so
 * we get Claude Code's built-in `cost.total_cost_usd` directly — host-agnostic,
 * independent of whatever statusLine the user has configured, and not scraped
 * from the rendered pane.
 *
 * ccrun drives the interactive subscription pool, so this is an estimated
 * API-equivalent cost — not a charge actually billed.
 *
 * Returns the dollar amount, or null if the payload is absent/unparseable or
 * carries no numeric cost.
 */
export function parseCostPayload(raw: string): number | null {
  const text = raw.trim();
  if (text.length === 0) return null;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const cost = (data as { cost?: unknown }).cost;
  if (!cost || typeof cost !== "object") return null;
  const total = (cost as { total_cost_usd?: unknown }).total_cost_usd;
  return typeof total === "number" && Number.isFinite(total) ? total : null;
}
