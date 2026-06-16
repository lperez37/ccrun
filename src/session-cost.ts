/**
 * Extract the session's running cost from Claude Code's REPL status footer.
 *
 * Claude Code prints a live status footer in the interactive REPL, e.g.
 *   /tmp │ 󰊠 Sonnet 4.6 │ $0.082 │ █░░░░░░░░░ 15%        30241 tokens
 * The `$0.082` is Claude Code's own cost figure for the session — authoritative
 * (it is what `/cost` reports and includes any sub-agent usage), so ccrun reads
 * it straight from the pane instead of re-deriving cost from a transcript (which
 * this driving flow does not reliably persist) or an embedded price table.
 *
 * ccrun runs on the interactive subscription pool, so this is an estimated
 * API-equivalent cost — not a charge actually billed on the subscription.
 *
 * Returns the dollar amount, or null when no footer cost is visible (e.g. the
 * cost display is disabled).
 */
// SGR color escapes (ESC[…m) are interleaved through the footer; without
// stripping them, the word boundary in /\btokens\b/ fails (e.g. "…153mtokens").
const ANSI_SGR = /\x1b\[[0-9;]*m/g;

export function parseSessionCostUsd(pane: string): number | null {
  const lines = pane.replace(ANSI_SGR, "").split("\n");
  // The footer sits near the bottom; scan upward and take the first line that
  // looks like the status footer (carries "tokens") and contains a "$" amount.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!/\btokens?\b/.test(line)) continue;
    const match = line.match(/\$\s?([0-9]+(?:\.[0-9]+)?)/);
    if (match) {
      const value = Number(match[1]);
      if (Number.isFinite(value)) return value;
    }
  }
  return null;
}
