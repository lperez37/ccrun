/**
 * Human-like keystroke cadence model (PLAN.md §5).
 *
 * Pure, deterministic data/logic only — NO tmux or IO calls live here
 * (tmux.ts owns IO). Everything is driven by a seedable RNG so tests are
 * reproducible and per-job cadence varies by job id, never by Math.random().
 *
 * Research grounding (Aalto 136M-keystroke study, Dhakal et al. 2018):
 * inter-key interval (IKI) is positively skewed (log-normal-ish), mean
 * ~238ms with a hard floor ~60ms — so we sample log-normal, not Gaussian,
 * and clamp to [floorMs, ceilMs].
 */

/** Inclusive [min, max] millisecond range used for boundary bonuses. */
export type MsRange = readonly [min: number, max: number];

export interface TypingProfile {
  /** Median inter-key interval in ms. Default 95 (fast typist). */
  readonly medianIkiMs: number;
  /** Log-normal shape parameter (sigma of underlying normal). Default 0.5. */
  readonly sigma: number;
  /** Hard floor clamp in ms. Default 55. */
  readonly floorMs: number;
  /** Hard ceiling clamp in ms. Default 1400. */
  readonly ceilMs: number;
  /** Extra pause sampled after a space character. */
  readonly wordPauseMs: MsRange;
  /** Extra pause sampled after sentence enders (. ? !) and newline. */
  readonly sentencePauseMs: MsRange;
  /** Probability [0,1] of a rare "think" hesitation before a character. */
  readonly thinkPauseChance: number;
  /** Pause sampled before the final submit (Enter). */
  readonly preSubmitPauseMs: MsRange;
  /**
   * Pause sampled BEFORE delivering a prompt at all — models the human glancing
   * at the screen / collecting their thoughts before typing or pasting. Applied
   * on BOTH the type and paste paths, so even a pasted (large/multiline) prompt
   * gets a human beat instead of landing instantly. Optional for back-compat;
   * falls back to DEFAULT_PREDELIVER_PAUSE_MS.
   */
  readonly preDeliverPauseMs?: MsRange;
}

/** Fallback pre-deliver "reading" pause when a profile omits preDeliverPauseMs. */
export const DEFAULT_PREDELIVER_PAUSE_MS: MsRange = [400, 1500];

/** Default fast-typist profile (keeps long prompts tolerable). */
export const DEFAULT_TYPING_PROFILE: TypingProfile = {
  medianIkiMs: 95,
  sigma: 0.5,
  floorMs: 55,
  ceilMs: 1400,
  wordPauseMs: [40, 180],
  sentencePauseMs: [180, 650],
  thinkPauseChance: 0.03,
  preSubmitPauseMs: [350, 1200],
  preDeliverPauseMs: [400, 1500],
};

/** A rare think-pause hesitation, sampled when it triggers. */
const THINK_PAUSE_MS: MsRange = [400, 1200];

/** Characters that mark the end of a sentence (newline handled separately). */
const SENTENCE_ENDERS: ReadonlySet<string> = new Set([".", "?", "!"]);

/**
 * Length threshold (chars) at or below which a single-line prompt is typed
 * character-by-character rather than pasted. See shouldType().
 */
export const TYPING_THRESHOLD = 220;

/** A deterministic uint32 RNG: returns floats in [0, 1). */
export type Rng = () => number;

/**
 * mulberry32 — small, fast, seedable PRNG. Deterministic for a given seed,
 * which is exactly what tests and per-job reproducibility need.
 */
export function mulberry32(seed: number): Rng {
  // Force to uint32 and keep state immutable to the caller via closure.
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Derive a stable uint32 seed from a job id (or any string) using FNV-1a.
 * Same id always yields the same seed, so a job's cadence is reproducible.
 */
export function seedFromJobId(jobId: string): number {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < jobId.length; i++) {
    hash ^= jobId.charCodeAt(i);
    // FNV prime 16777619, via Math.imul to stay in 32-bit space.
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Clamp a value into [min, max]. */
function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Standard-normal sample via the Box-Muller transform, driven by the seedable
 * RNG. Guards against log(0) by flooring the uniform draw.
 */
function standardNormal(rng: Rng): number {
  const u1 = Math.max(rng(), Number.EPSILON);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Sample a log-normal inter-key interval whose MEDIAN is profile.medianIkiMs,
 * then clamp to [floorMs, ceilMs]. Median-parameterized so the underlying
 * normal mean is ln(median) and exp(mu) == median.
 */
export function sampleIki(profile: TypingProfile, rng: Rng): number {
  const mu = Math.log(profile.medianIkiMs);
  const raw = Math.exp(mu + profile.sigma * standardNormal(rng));
  return clamp(raw, profile.floorMs, profile.ceilMs);
}

/** Sample a uniform integer-ish ms value within an inclusive range. */
export function sampleRange(range: MsRange, rng: Rng): number {
  const [min, max] = range;
  if (max <= min) return min;
  return min + (max - min) * rng();
}

/** A single emitted keystroke and the delay to wait BEFORE sending it. */
export interface Keystroke {
  readonly ch: string;
  readonly delayMs: number;
}

function isSentenceBoundary(ch: string): boolean {
  return ch === "\n" || SENTENCE_ENDERS.has(ch);
}

/**
 * Generate per-character keystrokes with human-shaped cadence.
 *
 * For each character the delay is:
 *   base log-normal IKI (clamped)
 *   + word-boundary bonus   (if the PRECEDING char was a space)
 *   + sentence-boundary bonus (if the preceding char ended a sentence / was \n)
 *   + rare think-pause      (with probability profile.thinkPauseChance)
 *
 * Boundary bonuses are attributed to the character that FOLLOWS the boundary,
 * modelling the pause a human takes after finishing a word/sentence before the
 * next keystroke. The think-pause roll is consumed for every character so the
 * RNG stream stays deterministic regardless of which branch fires.
 */
export function* keystrokes(
  text: string,
  profile: TypingProfile,
  rng: Rng,
): Iterable<Keystroke> {
  let prev: string | null = null;
  for (const ch of text) {
    let delayMs = sampleIki(profile, rng);

    if (prev === " ") {
      delayMs += sampleRange(profile.wordPauseMs, rng);
    }
    if (prev !== null && isSentenceBoundary(prev)) {
      delayMs += sampleRange(profile.sentencePauseMs, rng);
    }

    // Always consume one roll for the think-pause decision (deterministic
    // stream), then a second roll for its magnitude only when it fires.
    if (rng() < profile.thinkPauseChance) {
      delayMs += sampleRange(THINK_PAUSE_MS, rng);
    }

    yield { ch, delayMs };
    prev = ch;
  }
}

/**
 * Decide delivery mode for a prompt: type char-by-char vs. paste.
 * Type only when short (<= TYPING_THRESHOLD) AND single-line; otherwise paste
 * (what a human does with a big or multiline prepared prompt).
 */
export function shouldType(prompt: string): boolean {
  if (prompt.length > TYPING_THRESHOLD) return false;
  if (prompt.includes("\n")) return false;
  return true;
}

/** Sample the pre-submit (pre-Enter) pause for a profile. */
export function samplePreSubmitPause(profile: TypingProfile, rng: Rng): number {
  return sampleRange(profile.preSubmitPauseMs, rng);
}

/**
 * Sample the pre-deliver "reading/thinking" pause — the beat before any prompt
 * is typed or pasted. Falls back to DEFAULT_PREDELIVER_PAUSE_MS for profiles
 * (e.g. older fixtures) that omit the field.
 */
export function samplePreDeliverPause(profile: TypingProfile, rng: Rng): number {
  return sampleRange(profile.preDeliverPauseMs ?? DEFAULT_PREDELIVER_PAUSE_MS, rng);
}

/**
 * Build a TypingProfile from environment overrides on top of the default, so the
 * operator can tune the human cadence from the systemd unit without code changes.
 * Unset/invalid vars fall through to DEFAULT_TYPING_PROFILE. Ranges are "min,max".
 *
 *   TYPING_MEDIAN_IKI_MS, TYPING_SIGMA, TYPING_FLOOR_MS, TYPING_CEIL_MS,
 *   TYPING_THINK_CHANCE, TYPING_WORD_PAUSE_MS, TYPING_SENTENCE_PAUSE_MS,
 *   TYPING_PRESUBMIT_PAUSE_MS, TYPING_PREDELIVER_PAUSE_MS
 */
export function typingProfileFromEnv(
  env: Record<string, string | undefined> = {},
): TypingProfile {
  const num = (raw: string | undefined, fallback: number): number => {
    if (raw === undefined) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  };
  const range = (raw: string | undefined, fallback: MsRange): MsRange => {
    if (raw === undefined) return fallback;
    const parts = raw.split(",").map((s) => Number(s.trim()));
    if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) {
      return fallback;
    }
    const [min, max] = parts;
    return max >= min ? [min, max] : fallback;
  };
  const d = DEFAULT_TYPING_PROFILE;
  return {
    medianIkiMs: num(env.TYPING_MEDIAN_IKI_MS, d.medianIkiMs),
    sigma: num(env.TYPING_SIGMA, d.sigma),
    floorMs: num(env.TYPING_FLOOR_MS, d.floorMs),
    ceilMs: num(env.TYPING_CEIL_MS, d.ceilMs),
    thinkPauseChance: num(env.TYPING_THINK_CHANCE, d.thinkPauseChance),
    wordPauseMs: range(env.TYPING_WORD_PAUSE_MS, d.wordPauseMs),
    sentencePauseMs: range(env.TYPING_SENTENCE_PAUSE_MS, d.sentencePauseMs),
    preSubmitPauseMs: range(env.TYPING_PRESUBMIT_PAUSE_MS, d.preSubmitPauseMs),
    preDeliverPauseMs: range(
      env.TYPING_PREDELIVER_PAUSE_MS,
      d.preDeliverPauseMs ?? DEFAULT_PREDELIVER_PAUSE_MS,
    ),
  };
}

/**
 * Escape a single character for `tmux send-keys -l -- <ch>`.
 *
 * Ground-truth (tmux 3.5a, §10 fan-out): literal mode delivers EVERY tested
 * special char byte-perfectly under `-l --` — quotes, backticks, `& $ { } ( ) |
 * # ~`, backslash, `% ! * ? < > ^ @ : , . = + - [ ]` — with ONE exception: a
 * bare `;` sent as its own argument is SILENTLY DROPPED, because tmux's command
 * lexer treats `;` as a command separator BEFORE literal semantics apply (the
 * `--` guard does not help). Escaping it as `\;` delivers a literal `;`
 * perfectly, including consecutive `;;`.
 *
 * This is the ONLY transform needed; no other character requires escaping under
 * `-l --`. Kept as a tiny pure function so the semicolon bug can never silently
 * regress and `keystrokes`/`humanSendText` emission stays clean.
 */
export function escapeForSendKeysLiteral(ch: string): string {
  return ch === ";" ? "\\;" : ch;
}
