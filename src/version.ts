/**
 * Claude Code version drift guard.
 *
 * The pane-scraping fallback in `idle.ts` matches TUI strings (spinner glyphs,
 * the `…(Ns)` working counter, the `❯` prompt, the footer) that are tuned to a
 * specific Claude Code release. The happy path (the Stop hook's
 * `last_assistant_message`) does not depend on those patterns, but the fallback
 * does — so when the installed `claude` drifts far from the tuned target, the
 * fallback can silently misfire. We warn (never block) when that happens.
 */

/** The Claude Code release the pane patterns in idle.ts were tuned against. */
export const TUNED_CLAUDE_CODE_VERSION = "2.1.178";

/** Extract a `major.minor.patch` from `claude --version` output, or null. */
export function parseClaudeVersion(raw: string): string | null {
  const m = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

/**
 * Decide whether an installed version is "close enough" to the tuned target.
 * Same `major.minor` is considered safe (patch releases rarely move TUI strings);
 * a different major or minor is flagged as drift worth warning about.
 */
export function isTunedVersion(
  installed: string | null,
  tuned: string = TUNED_CLAUDE_CODE_VERSION,
): boolean {
  if (!installed) return false;
  const a = installed.split(".");
  const b = tuned.split(".");
  return a[0] === b[0] && a[1] === b[1];
}
